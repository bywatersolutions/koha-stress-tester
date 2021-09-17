#!/usr/bin/perl

use Modern::Perl;

use Data::Dumper;
use Getopt::Long::Descriptive;
use HTTP::Request::Common;
use JSON::XS;
use LWP::UserAgent;
use Parallel::ForkManager;
use Try::Tiny;
use WWW::Mechanize::Timed;
use List::Util qw(sum);
use Text::ASCIITable;

my ( $opt, $usage ) = describe_options(
    'koha-stress-test.pl %o ',
    [
        'staff-url|su=s',
        "The Koha staff URL to connect to",
        {
            required => 1,
            default  => $ENV{KOHA_INTRANET_URL} // 'http://127.0.0.1:8081'
        }
    ],
    [
        'opac-url|ou=s',
        "The Koha staff URL to connect to",
        {
            required => 1,
            default  => $ENV{KOHA_OPAC_URL} // 'http://127.0.0.1:8080'
        }
    ],
    [
        'username|u=s',
        "Koha username to use",
        { required => 1, default => $ENV{USERNAME} // 'koha' }
    ],
    [
        'password|p=s',
        "Password for Koha username",
        { required => 1, default => $ENV{PASSWORD} // 'koha' }
    ],
    [],
    [
        'checkouts|c=i',
        "Simultaneous virtual librarians checking out and checking in",
        { default => $ENV{CHECKOUTS} // 20 }
    ],
    [
        'checkouts-count|cc=i',
        "Number of checkouts each virtual librarian will process",
        { default => $ENV{CHECKOUTS_COUNT} // 20 }
    ],
    [],
    [
        'opac-searches|os=i',
        "Simultaneous public catalog searchs",
        { default => $ENV{OPAC_SEARCHES} // 20 }
    ],
    [
        'opac-searches-count|osc=i',
        "Number of searches each virtual patron will perform",
        { default => $ENV{CHECKOUTS_COUNT} // 20 }
    ],
    [],
    [
        'min-delay|min=i',
        "Minimum delay between actions",
        { default => $ENV{MIN_DELAY} // 1 }
    ],
    [
        'max-delay|max=i',
        "Maximum delay between actions",
        { default => $ENV{MAX_DELAY} // 5 }
    ],
    [],
    [ 'verbose|v', "print extra stuff" ],
    [ 'help|h',    "print usage message and exit", { shortcircuit => 1 } ],
);

print( $usage->text ), exit if $opt->help;

my $ua      = LWP::UserAgent->new();
my $request = GET $opt->staff_url . "/api/v1/libraries";

$request->authorization_basic( $opt->username, $opt->password );
my $response = $ua->request($request);
if ( $response->code() eq "401" ) {
    say
"Access to Koha REST API via Basic Auth is disabled. Please enable RESTBasicAuth.";
    exit;
}
my $libraries = decode_json( $response->decoded_content() );

my $pm = Parallel::ForkManager->new(999);

# data structure retrieval and handling
my @responses;
$pm->run_on_finish(
    sub {
        my ( $pid, $exit_code, $ident, $exit_signal, $core_dump, $data ) = @_;

        # see what the child sent us, if anything
        if ( defined($data) ) {    # test rather than assume child sent anything
            push( @responses, $data );
        }
    }
);

say "OPAC SEARCHES: " . $opt->opac_searches if $opt->verbose;
run_opac_searches( $opt, $pm )              if $opt->opac_searches > 0;

say "CHECKOUTS: " . $opt->checkouts if $opt->verbose;
run_checkouts( $opt, $pm )          if $opt->checkouts > 0;

sub run_opac_searches {
    my ( $opt, $pm ) = @_;

    my @search_keys = "a" .. "z";    ## TODO Add dictionary file?

    # run the parallel processes
  OPAC_SEARCHES:
    foreach my $opac_searches_counter ( 1 .. $opt->opac_searches ) {
        $pm->start() and next OPAC_SEARCHES;
        srand;
        my $data = {};

        my $agent = WWW::Mechanize::Timed->new( autocheck => 1 );

        my @pages;

        foreach my $opac_search ( 1 .. $opt->opac_searches_count ) {
            my $term = $search_keys[ rand @search_keys ];
            say "STARTING SEARCH $opac_search FOR OPAC SEARCHER $opac_searches_counter USING SEARCH TERM '$term' IN OPAC" if $opt->verbose;

            $agent->get( $opt->opac_url );
            $agent->form_name('searchform');
            $agent->field( 'q',   $term );
            $agent->field( 'idx', '' );
            $agent->click();

            push(
                @pages,
                {
                    type                => 'search_results',
                    client_total_time   => $agent->client_total_time,
                    client_elapsed_time => $agent->client_elapsed_time
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay;

            for my $i ( 1 .. 10 ) {
                my $last = 0;

                try {
                    say "CHECKING SEARCH RESULT $i FOR '$term' IN OPAC"
                      if $opt->verbose;

                    $agent->follow_link( n => $i, class => 'title' );
                    push(
                        @pages,
                        {
                            type                => 'result_details',
                            client_total_time   => $agent->client_total_time,
                            client_elapsed_time => $agent->client_elapsed_time
                        }
                    );
                    $agent->back;

                    sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
                      if $opt->min_delay && $opt->max_delay;
                }
                catch {
                    $last = 1;
                };

                last
                  if $last
                  ;    ## Supresses warning that shows if last is in catch block
            }
        }

        # send it back to the parent process
        $pm->finish( 0, { type => 'opac_search', pages => \@pages } );
    }
}

sub run_checkouts {
    my ( $opt, $pm ) = @_;

    my @search_keys = "a" .. "z";    ## TODO Add dictionary file?

    my $ua = LWP::UserAgent->new();

    ## For now, each librarian will check out all items to one patron each
    my $patrons_count = $opt->checkouts;
    my $request =
      GET $opt->staff_url . "/api/v1/patrons?_per_page=$patrons_count";
    $request->authorization_basic( $opt->username, $opt->password );
    my $response = $ua->request($request);
    my $patrons  = decode_json( $response->decoded_content() );

    my $items_count = $opt->checkouts_count * $opt->checkouts;
    $request = GET $opt->staff_url . "/api/v1/items?_per_page=$items_count";
    $request->authorization_basic( $opt->username, $opt->password );
    $response = $ua->request($request);
    my $items_json = decode_json( $response->decoded_content() );
    my @items;
    push( @items, [ splice @$items_json, 0, $opt->checkouts_count ] )
      while @$items_json;

    # run the parallel processes
  OPAC_SEARCHES:
    foreach my $checkouts_counter ( 1 .. $opt->checkouts ) {
        $pm->start() and next OPAC_SEARCHES;
        srand;

        my $patron       = $patrons->[ $checkouts_counter - 1 ];
        my $items_to_use = $items[ $checkouts_counter - 1 ];

        my $cardnumber = $patron->{cardnumber};

        my $data = {};

        my $agent = WWW::Mechanize::Timed->new( autocheck => 1 );

        my @pages;

        my $branch = $libraries->[0]->{library_id};

        $agent->get( $opt->staff_url . "/cgi-bin/koha/mainpage.pl" );
        $agent->form_name('loginform');
        $agent->field( 'password', $opt->password );
        $agent->field( 'userid',   $opt->username );
        $agent->field( 'branch',   $branch );
        $agent->click( '', 'login to staff interface' );

        # Checkin code duplicated below
        foreach my $item (@$items_to_use) {
            my $barcode = $item->{external_id};
            say "CHECKING IN $barcode" if $opt->verbose;
            $agent->get( $opt->staff_url . "/cgi-bin/koha/circ/returns.pl" );
            $agent->form_id('checkin-form');
            $agent->field( 'barcode', $barcode );
            $agent->click( '', 'Check in' );

            push(
                @pages,
                {
                    type                => 'checkin',
                    client_total_time   => $agent->client_total_time,
                    client_elapsed_time => $agent->client_elapsed_time
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
              if $opt->min_delay && $opt->max_delay;
        }

        $agent->get( $opt->staff_url . "/cgi-bin/koha/circ/circulation.pl" );
        $agent->form_id('patronsearch');
        $agent->field( 'findborrower', $cardnumber );
        $agent->click( '', 'Submit' );

        foreach my $item (@$items_to_use) {
            my $barcode = $item->{external_id};

            say "CHECKING OUT $barcode TO $cardnumber" if $opt->verbose;

            $agent->form_id('mainform');
            $agent->field( 'barcode', $barcode );
            $agent->click( '', 'Check out' );

            push(
                @pages,
                {
                    type                => 'checkout',
                    client_total_time   => $agent->client_total_time,
                    client_elapsed_time => $agent->client_elapsed_time
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
              if $opt->min_delay && $opt->max_delay;
        }

        # Checkin code duplicated above
        foreach my $item (@$items_to_use) {
            my $barcode = $item->{external_id};
            say "CHECKING IN $barcode" if $opt->verbose;
            $agent->get( $opt->staff_url . "/cgi-bin/koha/circ/returns.pl" );
            $agent->form_id('checkin-form');
            $agent->field( 'barcode', $barcode );
            $agent->click( '', 'Check in' );

            push(
                @pages,
                {
                    type                => 'checkin',
                    client_total_time   => $agent->client_total_time,
                    client_elapsed_time => $agent->client_elapsed_time
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
              if $opt->min_delay && $opt->max_delay;
        }

        # send it back to the parent process
        $pm->finish( 0, { type => 'circulation', pages => \@pages } );
    }
}

$pm->wait_all_children;

my $results = {
    opac_search_results_client_total_times   => [],
    opac_search_results_client_elapsed_times => [],
    opac_search_details_client_total_times   => [],
    opac_search_details_client_elapsed_times => [],
    checkin_client_elapsed_times             => [],
    checkin_client_total_times               => [],
    checkout_client_elapsed_times            => [],
    checkout_client_total_times              => [],
};

foreach my $r (@responses) {
    if ( $r->{type} eq 'opac_search' ) {
        my $pages = $r->{pages};

        foreach my $p (@$pages) {
            push(
                @{ $results->{opac_search_results_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'search_results';
            push(
                @{ $results->{opac_search_results_client_elapsed_times} },
                $p->{client_elapsed_time}
            ) if $p->{type} eq 'search_results';
            push(
                @{ $results->{opac_search_details_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'result_details';
            push(
                @{ $results->{opac_search_details_client_elapsed_times} },
                $p->{client_elapsed_time}
            ) if $p->{type} eq 'result_details';
        }
    }
    elsif ( $r->{type} eq 'circulation' ) {
        my $pages = $r->{pages};

        foreach my $p (@$pages) {
            push(
                @{ $results->{checkin_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'checkin';
            push(
                @{ $results->{checkin_client_elapsed_times} },
                $p->{client_elapsed_time}
            ) if $p->{type} eq 'checkin';
            push(
                @{ $results->{checkout_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'checkout';
            push(
                @{ $results->{checkout_client_elapsed_times} },
                $p->{client_elapsed_time}
            ) if $p->{type} eq 'checkout';
        }

    }
}

my $t = Text::ASCIITable->new( { headingText => 'Results' } );
$t->setCols( 'Type', 'Count', 'Average' );
foreach my $key ( keys %$results ) {
    my $times = $results->{$key};
    my $count = scalar @$times;
    next unless $count;
    my $average = sum(@$times) / $count;
    $t->addRow( $key, $count, $average );
}
print $t;
